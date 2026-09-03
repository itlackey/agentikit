// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Real-subprocess entrypoint test for global `--shape=summary` on a
 * non-`show` command.
 *
 * `--shape` is documented as a GLOBAL flag, so a command with no summary
 * projection degrades to the `agent` shape with a warning instead of
 * refusing outright — the same treatment `--format` gets on an exempt
 * command. This runs a real subprocess (rather than the in-process harness
 * in tests/_helpers/cli.ts) so the assertion that the write DID happen is
 * observed past the real entry point in src/cli.ts, not just the shaping
 * layer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Cleanup, withIsolatedAkmStorage } from "../_helpers/sandbox";

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

let cleanup: Cleanup = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function useStorage(): ReturnType<typeof withIsolatedAkmStorage> {
  const storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  return storage;
}

// The spawn passes `...process.env` on purpose: withIsolatedAkmStorage mutates
// process.env (AKM_* / XDG dirs) for the current process, and the subprocess
// must inherit those mutations to run against the isolated sandbox storage.
function runEntrypointSpawn(args: string[]) {
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 30_000,
  });
}

describe("entrypoint global --shape=summary on a non-show command", () => {
  test("warns and still performs the write, falling back to the agent shape", () => {
    const storage = useStorage();

    const result = runEntrypointSpawn(["--format=json", "--shape=summary", "remember", "write me anyway"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("not supported for 'akm remember'");
    expect(fs.readdirSync(path.join(storage.stashDir, "memories"))).not.toEqual([]);
  });
});
