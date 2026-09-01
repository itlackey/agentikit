// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint` fail-closed behavior (§24.2 "Lint" release gate).
 *
 * A mistyped invocation used to scan nothing and report a clean
 * `ok:true, flagged:0`: an unknown `--type` (e.g. singular "workflow")
 * filtered the sweep to zero directories, and a nonexistent `--dir` walked
 * nothing — both silently passing scripted `--fail-on-flagged` gates. Both
 * are now usage errors.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { akmLint } from "../src/commands/lint";
import { UsageError } from "../src/core/errors";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

describe("akm lint fails closed on mistyped invocations", () => {
  let storage: IsolatedAkmStorage;
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
  });
  afterEach(() => storage.cleanup());

  test("a nonexistent --dir is a usage error, not a clean result", async () => {
    const missing = path.join(storage.root, "no-such-bundle");
    await expect(akmLint({ dir: missing, config: makeConfig(storage.stashDir) })).rejects.toBeInstanceOf(UsageError);
  });

  test("an unknown --type on an akm bundle is a usage error naming the valid types", async () => {
    const attempt = akmLint({
      dir: storage.stashDir,
      typeFilter: "workflow", // singular — the classic typo for "workflows"
      config: makeConfig(storage.stashDir),
    });
    await expect(attempt).rejects.toBeInstanceOf(UsageError);
    await expect(attempt).rejects.toThrow(/workflows/);
  });

  test("a valid --type still lints normally", async () => {
    const result = await akmLint({
      dir: storage.stashDir,
      typeFilter: "workflows",
      config: makeConfig(storage.stashDir),
    });
    expect(result.ok).toBe(true);
  });
});
