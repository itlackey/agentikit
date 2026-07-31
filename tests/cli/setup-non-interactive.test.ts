// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm setup` must never block on a prompt without a TTY.
 *
 * The interactive wizard branch had no `process.stdin.isTTY` guard, so a
 * piped, redirected, or CI invocation rendered the first clack prompt and then
 * blocked forever (observed: exit 124 under `timeout`, no output). `akm setup`
 * is the first command users automate, so a hang there wedges the whole
 * pipeline. The guard fails fast with the documented non-interactive escape
 * hatches instead.
 *
 * `bun test` runs with a non-TTY stdin, which is exactly the condition under
 * test — no stdin stubbing required.
 */

import { describe, expect, test } from "bun:test";
import { runCliCapture } from "../_helpers/cli";

describe("akm setup without a TTY", () => {
  test("fails fast instead of hanging on the wizard prompt", async () => {
    expect(process.stdin.isTTY).not.toBe(true);

    const { code, stderr } = await runCliCapture(["setup"]);

    expect(code).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("NON_INTERACTIVE_REQUIRES_YES");
  });

  test("names every non-interactive escape hatch in the error", async () => {
    const { stderr } = await runCliCapture(["setup"]);
    const { error } = JSON.parse(stderr.trim()) as { error: string };

    expect(error).toContain("--yes");
    expect(error).toContain("--config");
    expect(error).toContain("--from");
  });

  test("classifies malformed --config JSON as a usage error", async () => {
    const { code, stderr } = await runCliCapture(["setup", "--config", "not-json"]);

    expect(code).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("Invalid JSON in --config");
  });
});
