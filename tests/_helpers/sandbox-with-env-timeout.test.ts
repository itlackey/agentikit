// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Regression coverage for `withEnv`'s optional `timeoutMs` safety net.
 *
 * CI incident (2026-07-27, node-smoke (24)): a single `withEnv`-wrapped call
 * in tests/integration/node-compat.test.ts hung past the file's 120s test
 * timeout. Because JS has no true promise cancellation, `withEnv`'s
 * restore-on-`finally` never ran — the override stayed applied to
 * `process.env` for the rest of the process's life. Every later test's own
 * `afterEach` inherited the pollution and tripped tests/_preload.ts's leak
 * tripwire (`AKM_FORCE_INIT_TMP_STASH`, `AKM_OUTPUT`), turning one hang into
 * 19 unrelated failures.
 *
 * These tests pin the fix directly against `withEnv` with a short, explicit
 * `timeoutMs` (not the 60s production constant) so they run in well under a
 * second: a `fn()` that never settles must still have its env override
 * undone by the deadline, and the omitted-`timeoutMs` call path must keep
 * behaving exactly as before (no timeout applied, restore only on settle).
 */

import { describe, expect, test } from "bun:test";
import { withEnv } from "./sandbox";

const PROBE_KEY = "AKM_SANDBOX_TIMEOUT_PROBE";

describe("withEnv timeoutMs safety net", () => {
  test("a hung fn() still has its env override restored by the deadline", async () => {
    expect(process.env[PROBE_KEY]).toBeUndefined();

    const hang = new Promise(() => {
      // Intentionally never settles — simulates a subprocess/network call
      // with no bound of its own.
    });

    let sawValueWhileHung: string | undefined;
    const call = withEnv(
      { [PROBE_KEY]: "set-during-call" },
      async () => {
        sawValueWhileHung = process.env[PROBE_KEY];
        await hang;
        return "unreachable";
      },
      25,
    );

    await expect(call).rejects.toThrow(/did not settle within 25ms/);

    expect(sawValueWhileHung).toBe("set-during-call");
    // The override must be gone once the bounded call has rejected — this is
    // the exact condition tests/_preload.ts's tripwire checks in afterEach.
    expect(process.env[PROBE_KEY]).toBeUndefined();
  });

  test("a hung fn() restores the PRIOR value (not just deletes) by the deadline", async () => {
    // Route the "pre-existing" seed through withEnv too (unbounded path) so
    // this test never assigns process.env directly — the outer call's own
    // restore-on-finally cleans up the key once we're done, regardless of
    // what the nested bounded call below does.
    await withEnv({ [PROBE_KEY]: "pre-existing" }, async () => {
      const hang = new Promise(() => {});
      const call = withEnv({ [PROBE_KEY]: "overridden" }, () => hang, 25);
      await expect(call).rejects.toThrow(/did not settle within 25ms/);
      expect(process.env[PROBE_KEY]).toBe("pre-existing");
    });
    expect(process.env[PROBE_KEY]).toBeUndefined();
  });

  test("omitting timeoutMs keeps the original unbounded behavior", async () => {
    const result = await withEnv({ [PROBE_KEY]: "set-during-call" }, () => {
      expect(process.env[PROBE_KEY]).toBe("set-during-call");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(process.env[PROBE_KEY]).toBeUndefined();
  });

  test("a fn() that settles well within timeoutMs resolves normally and restores env", async () => {
    const result = await withEnv({ [PROBE_KEY]: "set-during-call" }, () => "fast", 5_000);
    expect(result).toBe("fast");
    expect(process.env[PROBE_KEY]).toBeUndefined();
  });

  test("a thrown fn() still restores env with timeoutMs set", async () => {
    const call = withEnv(
      { [PROBE_KEY]: "set-during-call" },
      () => {
        throw new Error("boom");
      },
      5_000,
    );
    await expect(call).rejects.toThrow("boom");
    expect(process.env[PROBE_KEY]).toBeUndefined();
  });
});
