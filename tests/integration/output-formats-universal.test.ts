// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D7 — all six `--format` values work on every non-exempt command.
 *
 * Before D7 there were three inconsistent failure modes on a contract
 * `STABILITY.md` calls Stable: `md` silently emitted the JSON envelope
 * everywhere except `akm health`, `html` threw `INVALID_FLAG_VALUE` everywhere
 * except `akm health`, and `akm health` reached neither through `output()`
 * because it intercepted the format itself.
 *
 * This suite is deliberately table-driven over real commands rather than over
 * hand-picked payloads: a new command inherits the coverage, and the failure it
 * catches is the one that actually shipped — a format that "works" by handing
 * back a different format's bytes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "../_helpers/sandbox";

const FORMATS = ["json", "jsonl", "yaml", "text", "md", "html"] as const;

/**
 * Read-only commands exercised in every format. Each must be safe to run
 * against an empty-ish stash and must reach `output()` — that is the contract
 * under test. Mutating commands are covered by the html-does-not-block case
 * below rather than by running them six times each.
 */
const READ_COMMANDS: readonly (readonly string[])[] = [
  ["search", "alias"],
  ["list"],
  ["info"],
  ["config", "list"],
  ["env", "list"],
  ["secret", "list"],
  ["proposal", "list"],
  ["health"],
];

let stashDir = "";
let cleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  cleanup = stashResult.cleanup;

  const notePath = path.join(stashDir, "memories", "alias-note.md");
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, ["---", "description: Shell alias tip", "---", "", "Use aliases.", ""].join("\n"), "utf8");
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("every --format value produces real output on every read command", () => {
  for (const command of READ_COMMANDS) {
    for (const format of FORMATS) {
      test(`akm ${command.join(" ")} --format ${format}`, async () => {
        const result = await runCliCapture([...command, `--format=${format}`]);

        // `akm health` exits 4 on a health warning, which is success-shaped.
        expect([0, 4]).toContain(result.code);
        expect(result.stdout.trim().length).toBeGreaterThan(0);

        if (format === "html") {
          expect(result.stdout).toContain("<html");
          // The retired JSON-in-<pre> fallback is not an acceptable rendering.
          expect(result.stdout).not.toMatch(/<pre>\s*\{/);
        }
        if (format === "md") {
          // Must not be the JSON envelope wearing a markdown flag — that silent
          // wrong-format output is exactly what D7 removed.
          expect(result.stdout.trimStart().startsWith("{")).toBe(false);
        }
        if (format === "json") {
          expect(() => JSON.parse(result.stdout)).not.toThrow();
        }
      });
    }
  }
});

describe("html is no longer health-only", () => {
  test("a non-health read command renders html instead of exiting 2", async () => {
    const result = await runCliCapture(["list", "--format=html"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("<!doctype html>");
  });

  test("a mutating command completes its write under --format html", async () => {
    // The pre-D7 ordering hazard inverted: `html` used to be rejected at
    // startup, so this exited 2 without writing. It must now both write and
    // render — and the earlier bug where it wrote and THEN threw must not
    // return either.
    const result = await runCliCapture(["remember", "html format probe", "--format=html"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("<html");
    const memories = fs.readdirSync(path.join(stashDir, "memories"));
    expect(memories.some((f) => f !== "alias-note.md")).toBe(true);
  });
});

describe("akm health keeps its bespoke reports through the registry", () => {
  test("--report --format html renders the report template, not the generic fallback", async () => {
    const result = await runCliCapture(["health", "--report", "--format=html"]);

    expect([0, 4]).toContain(result.code);
    // The report template carries content the generic renderer never emits.
    expect(result.stdout).toContain("<html");
    expect(result.stdout).not.toContain("<h1>akm health</h1>");
  });

  test("--format md renders the per-run table for a run-grouped read", async () => {
    const result = await runCliCapture(["health", "--group-by=run", "--format=md"]);

    expect([0, 4]).toContain(result.code);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout.trimStart().startsWith("{")).toBe(false);
  });

  test("the renderers are data-driven: plain health under html falls to the generic rendering", async () => {
    const result = await runCliCapture(["health", "--format=html"]);

    expect([0, 4]).toContain(result.code);
    expect(result.stdout).toContain("<h1>akm health</h1>");
  });
});

describe("graph export has no local --format", () => {
  // Exporting a real artifact needs a stored graph snapshot, which only the
  // graph-extraction flow produces — out of scope here. What D7 changed is the
  // ARGUMENT surface: `--format` used to be declared locally as well as
  // globally (one token, two parsers). These pin that the global flag now
  // reaches the command unopposed, by asserting each format gets as far as
  // loading the graph (exit 1, FILE_NOT_FOUND) rather than being rejected as
  // usage (exit 2) or accepted only for json/jsonl.
  for (const format of ["jsonl", "md", "html", "yaml"] as const) {
    test(`--format ${format} reaches graph loading rather than a usage error`, async () => {
      const out = path.join(stashDir, `graph-${format}.out`);
      const result = await runCliCapture(["graph", "export", `--out=${out}`, `--format=${format}`]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("FILE_NOT_FOUND");
    });
  }

  test("--out is still required, and its usage error is unaffected by the format", async () => {
    const result = await runCliCapture(["graph", "export", "--format=md"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("MISSING_REQUIRED_ARGUMENT");
  });
});
