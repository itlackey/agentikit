// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * 0.9.2 workflow release gate (src/core/workflows-gate.ts).
 *
 * The suite preload (tests/_preload.ts) lifts the gate process-wide with
 * `AKM_ENABLE_WORKFLOWS=1` so the workflow suites exercise the real
 * implementation. These tests delete that variable to assert the CLOSED
 * behavior every 0.9.2 user sees by default; the preload's HARNESSED
 * afterEach snapshot restores it between tests.
 *
 * Remove this file together with the gate when 0.9.3 re-enables workflows.
 */

import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/core/errors";
import { assertWorkflowsEnabled, workflowsEnabled } from "../src/core/workflows-gate";
import { runCliCapture } from "./_helpers/cli";

function closeGate(): void {
  delete process.env.AKM_ENABLE_WORKFLOWS;
}

function expectDisabledEnvelope(stderr: string): void {
  const envelope = JSON.parse(stderr) as { ok: boolean; error: string; code?: string; hint?: string };
  expect(envelope.ok).toBe(false);
  expect(envelope.code).toBe("WORKFLOWS_DISABLED");
  expect(envelope.error).toContain("disabled in akm 0.9.2");
  expect(envelope.error).toContain("re-enabled in 0.9.3");
  expect(envelope.hint).toContain("AKM_ENABLE_WORKFLOWS=1");
}

describe("workflows release gate (0.9.2)", () => {
  test("assertWorkflowsEnabled fails closed by default and opens only on the exact value 1", () => {
    closeGate();
    expect(workflowsEnabled()).toBe(false);
    expect(() => assertWorkflowsEnabled()).toThrow(UsageError);

    process.env.AKM_ENABLE_WORKFLOWS = "true";
    expect(workflowsEnabled()).toBe(false);

    process.env.AKM_ENABLE_WORKFLOWS = "1";
    expect(workflowsEnabled()).toBe(true);
    expect(() => assertWorkflowsEnabled()).not.toThrow();
  });

  test("every `akm workflow` subcommand exits 2 with the release notice", async () => {
    closeGate();
    for (const argv of [
      ["workflow", "list"],
      ["workflow", "status", "run-1"],
      ["workflow", "run", "workflows/demo"],
      ["workflow", "create", "demo", "--print"],
      ["workflow", "resume", "run-1"],
      ["workflow", "abandon", "run-1"],
    ]) {
      const result = await runCliCapture(argv);
      expect(result.code).toBe(2);
      expectDisabledEnvelope(result.stderr);
    }
  });

  test("`akm task add --workflow` is rejected before touching any bundle", async () => {
    closeGate();
    const result = await runCliCapture([
      "task",
      "add",
      "nightly-demo",
      "--schedule",
      "@daily",
      "--workflow",
      "workflows/demo",
    ]);
    expect(result.code).toBe(2);
    expectDisabledEnvelope(result.stderr);
  });

  test("with the escape hatch set, workflow commands run again", async () => {
    // The suite preload already sets AKM_ENABLE_WORKFLOWS=1; assert the open
    // path on the one workflow command that needs no config or bundle.
    const result = await runCliCapture(["workflow", "create", "demo", "--print"]);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr).not.toContain("WORKFLOWS_DISABLED");
  });
});
