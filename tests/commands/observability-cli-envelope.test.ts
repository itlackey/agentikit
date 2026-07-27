// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the observability command cluster
 * (`akm log list`, `akm lessons coverage`, `akm hints`). Pins the JSON
 * envelope (stdout payload shape, the {ok:false,code} error envelope on stderr,
 * and exit codes) for representative subcommands, proving the extraction from
 * cli.ts into src/commands/observability-cli.ts is byte-identical.
 *
 * `log list` and `lessons coverage` were migrated onto `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form. `lessons coverage` pins both envelope shapes, each in its own
 * deterministic test: the success payload (uncoveredTags/lessonTagCount/
 * totalTagCount on stdout, exit 0) when an index exists, or the {ok:false}
 * error envelope on stderr (exit 70, INTERNAL/H6) when it does not — either
 * way the result is routed through runWithJsonErrors. `hints` keeps a
 * plain `defineCommand` wrapping `runWithJsonErrors` because it writes the
 * guide directly to stdout; its --detail validation still emits the structured
 * usage envelope.
 *
 * `log tail` is intentionally not exercised here — it follows the events table
 * via a polling loop and would make this snapshot non-deterministic. It is
 * covered by its own behavior tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, sandboxStashDir, sandboxXdgDataHome, writeSandboxConfig } from "../_helpers/sandbox";

let stashCleanup: Cleanup = () => {};
let stashDir = "";

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

beforeEach(() => {
  // Chain sandboxXdgDataHome onto sandboxStashDir so `index.db` (which lives
  // under XDG_DATA_HOME, see src/core/paths.ts:getDataDir) is isolated
  // per-test too — not just AKM_STASH_DIR. Previously this beforeEach left
  // XDG_DATA_HOME pointed at the process-wide preload sandbox, which every
  // test in the shard shares; whether `lessons coverage`'s index.db already
  // existed there depended on what other tests ran earlier in the same
  // worker (VALUE-06). A fresh XDG_DATA_HOME per test makes "no index yet"
  // and "index exists" both deterministic.
  const stash = sandboxStashDir();
  const data = sandboxXdgDataHome(stash.cleanup);
  stashDir = stash.dir;
  stashCleanup = data.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
  stashDir = "";
});

describe("akm observability cluster — JSON envelope snapshot (WS6)", () => {
  test("log list: success envelope carries events array + totalCount + nextOffset", async () => {
    const { stdout, status } = await runCli(["--json", "log", "list"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.events)).toBe(true);
    expect(typeof env.totalCount).toBe("number");
    expect(typeof env.nextOffset).toBe("number");
  });

  // VALUE-06: previously one test asserted both envelope shapes behind an
  // `if (status === 0) … else …` branch, which is non-deterministic (it
  // depended on whether some earlier test in the shard had already built an
  // index.db under the then-shared XDG_DATA_HOME). Split into two
  // deterministic tests, each forcing its own branch.
  test("lessons coverage: emits the coverage envelope when an index exists", async () => {
    // Build a real (if trivial) index so `coverage` takes the success path
    // deterministically, independent of any other test's state.
    resetConfigCache();
    saveConfig({ semanticSearchMode: "off" });
    fs.writeFileSync(path.join(stashDir, "memories", "note.md"), "---\ndescription: note\ntags: [demo]\n---\nBody.\n");
    await akmIndex({ stashDir, full: true });

    const { stdout, status } = await runCli(["--json", "lessons", "coverage"]);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.uncoveredTags)).toBe(true);
    expect(typeof env.lessonTagCount).toBe("number");
    expect(typeof env.totalTagCount).toBe("number");
  });

  test("lessons coverage: emits {ok:false} on stderr (exit 70) when no index exists", async () => {
    // No akmIndex() call — the isolated XDG_DATA_HOME from beforeEach has no
    // index.db, so `coverage` deterministically takes the no-index path.
    //
    // H6 (code-health round-2): when there is no index DB, `coverage` opens
    // the database and a bare (non-AkmError) failure escapes. That is
    // classified as INTERNAL (exit 70, sysexits EX_SOFTWARE) rather than the
    // old catch-all 1 — the whole point of H6 is that "akm threw
    // unexpectedly" is distinguishable from an ordinary NotFoundError (1).
    // This branch is covered nowhere else in the suite — it MUST survive.
    const { stderr, status } = await runCli(["--json", "lessons", "coverage"]);
    expect(status).toBe(70);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(typeof env.error).toBe("string");
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
