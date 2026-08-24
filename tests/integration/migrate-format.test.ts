// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm migrate status`/`apply` honouring `--format` (D7) instead of always
 * emitting the standalone `akm-migrate` tool's fixed JSON and warning that
 * `--format` "has no effect" (`src/commands/migrate-cli.ts`,
 * `src/output/shapes/migrate.ts`, `src/output/text/migrate.ts`).
 */

import { expect, test } from "bun:test";
import fs from "node:fs";
import { getLegacyWorkflowDbPath } from "../../scripts/akm-migrate/migrate/legacy/legacy-paths";
import { getConfigPath, getStateDbPathInDataDir } from "../../src/core/paths";
import { isFormatExemptCommand } from "../../src/output/format-exempt";
import { openStateDbAtCeiling, PRE_CUTOVER_STATE_CEILING } from "../_fixtures/migration/seed-rows";
import { runCliCapture } from "../_helpers/cli";
import { openLegacyWorkflowDb } from "../_helpers/legacy-workflow-db";
import { withIsolatedAkmStorage } from "../_helpers/sandbox";

function seedLegacyInstall(storage: ReturnType<typeof withIsolatedAkmStorage>) {
  fs.writeFileSync(getConfigPath(), `${JSON.stringify({ stashDir: storage.stashDir, sources: [] })}\n`, {
    mode: 0o600,
  });
  openStateDbAtCeiling(getStateDbPathInDataDir(), PRE_CUTOVER_STATE_CEILING).close();
  openLegacyWorkflowDb(getLegacyWorkflowDbPath()).close();
}

function writeContentMigrationFixture(stashDir: string): void {
  const dir = `${stashDir}/memories`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/note.md`, "---\ndescription: generated\n---\n\nNote body.\n", "utf8");
  fs.writeFileSync(
    `${dir}/.stash.json`,
    `${JSON.stringify({
      entries: [{ name: "note", type: "memory", filename: "note.md", description: "curated" }],
    })}\n`,
    "utf8",
  );
}

test("migrate status/apply are no longer format-exempt", () => {
  expect(isFormatExemptCommand(["migrate", "status"])).toBe(false);
  expect(isFormatExemptCommand(["migrate", "apply"])).toBe(false);
  expect(isFormatExemptCommand(["migrate"])).toBe(false);
});

test("migrate status --format text renders a real text document, no 'has no effect' warning", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    seedLegacyInstall(storage);
    const result = await runCliCapture(["migrate", "status", "--format", "text"]);
    expect(result.stderr).not.toContain("has no effect");
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout).toContain("blocked");
    expect(result.stdout).toContain("artifacts:");
    expect(result.stdout).toContain("config.json: old");
  } finally {
    storage.cleanup();
  }
});

test("migrate status --format md/html/yaml each render without the 'has no effect' warning", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    seedLegacyInstall(storage);
    for (const format of ["md", "html", "yaml"]) {
      const result = await runCliCapture(["migrate", "status", "--format", format]);
      expect(result.stderr, format).not.toContain("has no effect");
      expect(result.stdout, format).toContain("blocked");
    }
  } finally {
    storage.cleanup();
  }
});

test("migrate status --format json still parses to the same plan as the unflagged default", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    seedLegacyInstall(storage);
    const bare = await runCliCapture(["migrate", "status"]);
    const explicit = await runCliCapture(["migrate", "status", "--format", "json"]);
    expect(JSON.parse(explicit.stdout)).toEqual(JSON.parse(bare.stdout));
  } finally {
    storage.cleanup();
  }
});

test("migrate apply --format text renders both the generate-only stop and the completed cutover as text", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    seedLegacyInstall(storage);
    // First apply: generates the starter config and stops (no --config given).
    const first = await runCliCapture(["migrate", "apply", "--format", "text"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("ready");
    expect(first.stdout).toContain("Generated a starter 0.9 config");

    // Second apply completes the cutover — still renders as text, not JSON.
    const second = await runCliCapture(["migrate", "apply", "--format", "text"]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain("current");
    expect(() => JSON.parse(second.stdout)).toThrow();
  } finally {
    storage.cleanup();
  }
});

test("migrate apply --format text prints a real progress-event line verbatim ahead of the formatted result", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    seedLegacyInstall(storage);
    writeContentMigrationFixture(storage.stashDir);
    const prepared = `${storage.root}/prepared.json`;
    fs.writeFileSync(
      prepared,
      `${JSON.stringify({
        configVersion: "0.9.0",
        bundles: { primary: { path: storage.stashDir, writable: true } },
        defaultBundle: "primary",
      })}\n`,
      { mode: 0o600 },
    );

    const applied = await runCliCapture(["migrate", "apply", "--config", prepared, "--format", "text"]);
    expect(applied.code, applied.stderr).toBe(0);
    const lines = applied.stdout.split("\n").filter((line) => line.length > 0);

    // The progress-event line is untouched raw JSON — never reformatted —
    // and precedes the human-readable rendering of the final result.
    const eventLineIndex = lines.findIndex((line) => line.includes('"event":"content-migration"'));
    expect(eventLineIndex).toBeGreaterThanOrEqual(0);
    expect(() => JSON.parse(lines[eventLineIndex] as string)).not.toThrow();
    const parsedEvent = JSON.parse(lines[eventLineIndex] as string) as { sidecarsFolded: number };
    expect(parsedEvent.sidecarsFolded).toBe(1);

    const resultGlyphIndex = lines.findIndex((line) => line.includes("current"));
    expect(resultGlyphIndex).toBeGreaterThan(eventLineIndex);
    expect(() => JSON.parse(applied.stdout)).toThrow(); // whole stdout is not one JSON document
  } finally {
    storage.cleanup();
  }
});
