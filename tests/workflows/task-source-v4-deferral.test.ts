// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2b Lane A (spec docs/plans/specs/p2b-input-bindings.md §1.7 A-N6, §7
 * F-A4) supersedes p2a's LC-N1/B-24: the peek-and-throw deferral this file
 * used to pin is GONE. `taskDispatch` (`src/workflows/freeze/targets/task.ts`)
 * now routes through `parseTaskSource`, and a workflow step's
 * `uses: tasks/<ref>` targeting a `version: 4` task source COMPOSES —
 * A-N6's own comment records the supersession, and
 * `docs/plans/specs/p2a-task-source-v4.md`'s Review log carries the dated
 * note (F-A4's own close-out obligation).
 *
 * The first test below is REWRITTEN IN PLACE (same path, per F-A4) to assert
 * that composition: the step freezes to a real dispatch, and the step's
 * authored `with:` binds the v4 target's declared `inputs:` (A-N7's
 * `inputBindings`, §3.3). The second test (the v3-contrast companion) is
 * UNCHANGED — LC-N1's guard never distinguished v3 from v4 by treating v3
 * specially, so its own absence was always the control case, and it stays a
 * useful proof that composing a version: 3 task is unaffected by any of
 * this.
 *
 * Sandbox/freeze pattern follows tests/workflows/with-rejection.test.ts
 * (withIsolatedAkmStorage + writeWorkflowTestConfig + akmIndex +
 * startWorkflowRun).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { withWorkflowRunsRepo } from "../../src/storage/repositories/workflow-runs-repository";
import { decodeWorkflowPlanV4, type FrozenWorkflowTarget } from "../../src/workflows/ir/schema-v4";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const STEP_ID = "dispatch";
const TASK_REF = "tasks/nightly-v4";

describe("A-N6/F-A4 — a task source v4 target composes from a workflow step (supersedes p2a's LC-N1/B-24)", () => {
  let storage: IsolatedAkmStorage;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    writeWorkflowTestConfig();
    resetConfigCache();
  });

  afterEach(() => {
    resetConfigCache();
    storage.cleanup();
  });

  function write(relative: string, content: string): void {
    const file = path.join(storage.stashDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  /** Run `ref` and return whatever it throws, or undefined if it resolves. */
  async function captureRejection(ref: string): Promise<unknown> {
    try {
      await startWorkflowRun(ref);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  test("a workflow step uses: tasks/<ref> whose task source is version: 4 composes: the step freezes, and its bindings land", async () => {
    // Unlike the old deferral test, composition now actually resolves the
    // v4 target's OWN uses:, so commands/review needs a real backing file.
    write("commands/review.md", "Review the workflow-composed task source v4 target.\n");
    write(
      "tasks/nightly-v4.yml",
      [
        "version: 4",
        "name: Nightly review",
        "uses: commands/review",
        "inputs:",
        "  scope:",
        "    type: string",
        "    default: changed",
        "",
      ].join("\n"),
    );
    write(
      `workflows/${STEP_ID}.yml`,
      [
        "name: Task source v4 composition",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        `      - id: ${STEP_ID}`,
        `        uses: ${TASK_REF}`,
        "        with:",
        "          scope: all",
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    // The step freezes — no error, unlike the superseded LC-N1 deferral.
    const started = await startWorkflowRun(`workflows/${STEP_ID}`);
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = decodeWorkflowPlanV4(JSON.parse(row?.plan_json ?? "null"));
    const root = plan.steps[0]?.root;
    const target: FrozenWorkflowTarget | undefined = root && root.kind !== "map" ? root.frozenTarget : undefined;

    // ...and its bindings land: the authored with.scope literal binds the
    // v4 target's declared "scope" input (A-N7's inputBindings).
    expect(target?.kind).toBe("command");
    expect(target?.inputBindings).toEqual([{ kind: "literal", name: "scope", value: "all" }]);
  });

  // PRESERVED companion (must stay green through and after Implement): the
  // SAME workflow step targeting a version: 3 task keeps freezing normally —
  // LC-N1's guard must fire ONLY on version: 4, never on version: 3.
  test("the identical step targeting a version: 3 task is unaffected by the LC-N1 guard", async () => {
    write("commands/review.md", "Review the workflow-composed task target.\n");
    write(
      "tasks/nightly-v3.yml",
      ["version: 3", "uses: commands/review", "akm:", '  schedule: "@daily"', ""].join("\n"),
    );
    write(
      "workflows/v3-companion.yml",
      [
        "name: v3 companion",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        `      - id: ${STEP_ID}`,
        "        uses: tasks/nightly-v3",
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection("workflows/v3-companion");
    expect(error).toBeUndefined();
  });
});
