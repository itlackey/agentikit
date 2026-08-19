// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Process-boundary portion of WP0's non-normative harness characterization.
 *
 * The OpenCode SDK injected-server seam is process-global, so exercising it
 * beside the SDK runner's timer tests would create cross-file test coupling.
 * The helper performs the capture in a short-lived process instead.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EXECUTION_CONTRACT_FIXTURES } from "../_helpers/execution-contracts";

interface ExpectedSdkLowering {
  config: Record<string, unknown>;
  request: Record<string, unknown>;
  result: {
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    sessionId?: string;
  };
}

test("OpenCode SDK request lowering matches the non-normative current fixture in an isolated process", async () => {
  const expected = JSON.parse(
    readFileSync(path.join(EXECUTION_CONTRACT_FIXTURES, "lowering/current.json"), "utf8"),
  ) as { opencodeSdk: ExpectedSdkLowering };
  const helper = path.resolve(import.meta.dir, "../_helpers/capture-opencode-sdk-lowering.ts");
  const child = Bun.spawn([process.execPath, helper], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, stderr).toBe(0);
  expect(JSON.parse(stdout) as ExpectedSdkLowering).toEqual(expected.opencodeSdk);
});
