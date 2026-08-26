// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Test-review remediation (spec docs/plans/specs/p2a-task-source-v4.md §1.5
 * LC-N1, B-24) for the finding recorded against
 * docs/plans/specs/p2a-task-source-v4.md:518: nothing exercised a workflow
 * step targeting a `version: 4` task source, so `taskDispatch`'s LC-N1
 * pre-parse deferral guard (`src/workflows/ir/source-freeze-v4.ts:231`) had
 * zero coverage.
 *
 * Sandbox/freeze pattern follows tests/workflows/with-rejection.test.ts
 * (withIsolatedAkmStorage + writeWorkflowTestConfig + akmIndex +
 * startWorkflowRun).
 *
 * RED today: `taskDispatch` has no version-peek guard yet — it calls
 * `parseTaskV3Yaml` directly on the task source, which (for a `version: 4`
 * document) fails v3's OWN `version must be exactly 3.` check. That IS a
 * `UsageError` coded `TASK_SOURCE_INVALID` today too (the same code LC-N1
 * specifies), so the discriminating signal below is the MESSAGE TEXT, not
 * the code: today's message is the v3 "version must be exactly 3." wart
 * (D2-N2); LC-N1's verbatim deferral message is quoted in full in the spec,
 * so it is pinned byte-exactly here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../src/core/config/config";
import { UsageError } from "../../src/core/errors";
import { akmIndex } from "../../src/indexer/indexer";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

const STEP_ID = "dispatch";
const TASK_REF = "tasks/nightly-v4";
// LC-N1's message, verbatim (spec §1.5): quoted in full there, so pinned
// byte-exactly rather than matched loosely.
const DEFERRAL_MESSAGE =
  `Workflow step "${STEP_ID}" targets task ${TASK_REF}, which uses task source v4. Composing a ` +
  "task source v4 target from a workflow arrives in a later 0.9.x release; keep the " +
  "task at version 3 until then.";

describe("LC-N1 — a task source v4 target is not yet composable from a workflow step (B-24)", () => {
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

  test("a workflow step uses: tasks/<ref> whose task source is version: 4 rejects with UsageError/TASK_SOURCE_INVALID naming the deferral, byte-exact", async () => {
    // The v4 task's OWN target (commands/review) is deliberately never
    // backed by a real commands/review.md — LC-N1's guard fires from a
    // version PEEK, before any downstream resolution of the v4 document's
    // own uses:, mirroring with-rejection.test.ts's B-02b placement proof
    // (the with: guard fires before resolveOwnedAsset too). If the guard
    // were placed AFTER attempting to resolve the v4 target, this test would
    // fail for the wrong reason (an asset-resolution error) instead of
    // LC-N1's deferral message.
    write("tasks/nightly-v4.yml", ["version: 4", "name: Nightly review", "uses: commands/review", ""].join("\n"));
    write(
      `workflows/${STEP_ID}.yml`,
      [
        "name: Task source v4 composition deferral",
        "on:",
        "  workflow_dispatch:",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        `      - id: ${STEP_ID}`,
        `        uses: ${TASK_REF}`,
        "",
      ].join("\n"),
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const error = await captureRejection(`workflows/${STEP_ID}`);
    expect(error).toBeInstanceOf(UsageError);
    if (!(error instanceof UsageError)) return;
    expect(error.code).toBe("TASK_SOURCE_INVALID");
    expect(error.message).toBe(DEFERRAL_MESSAGE);
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
