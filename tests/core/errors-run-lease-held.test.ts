// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `RUN_LEASE_HELD` is the dedicated `UsageErrorCode` a workflow run-lease
 * refusal carries, distinct from the generic `INVALID_FLAG_VALUE` default —
 * a caller branching on `code` can retry this one, unlike a bad flag.
 */

import { describe, expect, test } from "bun:test";
import { UsageError } from "../../src/core/errors";

describe("RUN_LEASE_HELD", () => {
  test("constructible, kind usage, code round-trips, and carries its own default hint", () => {
    const error = new UsageError("Workflow run x is already being driven by engine y.", "RUN_LEASE_HELD");
    expect(error).toBeInstanceOf(UsageError);
    expect(error).toBeInstanceOf(Error);
    expect(error.kind).toBe("usage");
    expect(error.code).toBe("RUN_LEASE_HELD");
    expect(error.hint()).toBeDefined();
    expect(error.hint()).not.toBe(new UsageError("x").hint());
  });

  test("an explicit constructor hint still overrides the default", () => {
    const error = new UsageError("x", "RUN_LEASE_HELD", "explicit override");
    expect(error.hint()).toBe("explicit override");
  });

  test("distinct from the default INVALID_FLAG_VALUE code a caller might otherwise conflate it with", () => {
    expect(new UsageError("x", "RUN_LEASE_HELD").code).not.toBe(new UsageError("x").code);
  });
});
