// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #914: `akm health --no-probe` must actually route through to skip the
 * reachability probes. This pins a real citty gotcha found while wiring the
 * flag: citty's argument parser treats ANY `--no-X` argument as negating a
 * flag named `X` (stripping the `no-` prefix unconditionally — see
 * `parseArgs` in `citty`'s `dist/index.mjs`), so declaring an arg literally
 * named `"no-probe"` would silently never populate `args["no-probe"]` and
 * `--no-probe` would do nothing. The fix declares a positive `probe` arg
 * (default `true`); `--no-probe` is citty's automatic negation of it.
 *
 * This test exercises the CLI end-to-end (not just `runDefaultLlmEngineProbe`
 * directly) specifically so a regression in the flag NAME/wiring — not just
 * the underlying probe logic already covered by
 * `tests/health-engine-probe.test.ts` — fails loudly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  withMockedFetch,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    engines: {
      lab: { kind: "llm", endpoint: "http://127.0.0.1:9/v1/chat/completions", model: "test-model" },
    },
    defaults: { llmEngine: "lab" },
  });
});

afterEach(() => {
  storage.cleanup();
});

function chatCompletionResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("akm health --no-probe (#914)", () => {
  test("without --no-probe, the reachability probe actually fires (a real fetch)", async () => {
    let fetchCalls = 0;
    const { code, stdout } = await withMockedFetch(
      () => runCliCapture(["health", "--format", "json"]),
      () => {
        fetchCalls += 1;
        return chatCompletionResponse();
      },
    );
    expect(fetchCalls).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout) as { hardChecks: Array<{ name: string; status: string; message: string }> };
    const check = parsed.hardChecks.find((c) => c.name === "default-llm-engine");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("reachable");
    expect(code).toBe(0);
  });

  test("--no-probe skips the reachability probe entirely (no fetch call)", async () => {
    let fetchCalls = 0;
    const { code, stdout } = await withMockedFetch(
      () => runCliCapture(["health", "--no-probe", "--format", "json"]),
      () => {
        fetchCalls += 1;
        return chatCompletionResponse();
      },
    );
    expect(fetchCalls).toBe(0);
    const parsed = JSON.parse(stdout) as { hardChecks: Array<{ name: string; status: string; message: string }> };
    const check = parsed.hardChecks.find((c) => c.name === "default-llm-engine");
    expect(check?.status).toBe("pass");
    expect(check?.message).toContain("Reachability was not probed");
    expect(code).toBe(0);
  });
});
