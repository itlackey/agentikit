// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the observability command cluster
 * (`akm log`, `akm hints`). Pins the JSON envelope (stdout payload shape, the
 * {ok:false,code} error envelope on stderr, and exit codes) for representative
 * subcommands, proving the extraction from cli.ts into
 * src/commands/observability-cli.ts is byte-identical.
 *
 * `log` was migrated onto `defineJsonCommand`, which emits the same JSON
 * envelope (stdout/stderr/exit-code) as the inline form. `hints` keeps a
 * plain `defineCommand` wrapping `runWithJsonErrors` because it writes the
 * guide directly to stdout; its --detail validation still emits the structured
 * usage envelope.
 *
 * 0.9.0 CLI overhaul (S3): `log` was a group with `list`/`tail` subcommands;
 * `tail` is dropped and `log` is now the leaf command (today's `list`
 * surface, unchanged). The `lessons`/`lesson` group (`coverage`, `strength`)
 * is dropped entirely along with its envelope tests below.
 *
 * `log tail` was intentionally not exercised here — it followed the events
 * table via a polling loop and would have made this snapshot
 * non-deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, sandboxXdgDataHome, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

beforeEach(() => {
  // Chain sandboxXdgDataHome onto sandboxStashDir so `index.db` (which lives
  // under XDG_DATA_HOME, see src/core/paths.ts:getDataDir) is isolated
  // per-test too — not just AKM_BUNDLE_DIR.
  const stash = sandboxStashDir();
  const data = sandboxXdgDataHome(stash.cleanup);
  stashCleanup = data.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
});

describe("akm observability cluster — JSON envelope snapshot (WS6)", () => {
  test("log: success envelope carries events array + totalCount + nextOffset", async () => {
    const { stdout, status } = await runCli(["--json", "log"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.events)).toBe(true);
    expect(typeof env.totalCount).toBe("number");
    expect(typeof env.nextOffset).toBe("number");
  });

  test("hints: prints the embedded AGENTS guide to stdout (exit 0)", async () => {
    const { stdout, status } = await runCli(["hints"]);
    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout).toMatch(/akm/i);
  });

  test("hints --detail <bogus>: parseDetailLevel → {ok:false} usage envelope on stderr (exit 2)", async () => {
    const { stderr, status } = await runCli(["--json", "hints", "--detail", "bogus"]);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_DETAIL_VALUE");
    expect(env.error).toMatch(/Invalid value for --detail/);
  });
});
