// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmIndex } from "../../src/indexer/indexer";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(async () => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "fixture",
    bundles: {
      fixture: {
        path: storage.stashDir,
        components: { main: { root: ".", adapter: "akm" } },
      },
    },
    engines: {
      reviewer: { kind: "agent", platform: "claude", bin: "/bin/echo", args: [] },
    },
    defaults: { engine: "reviewer" },
  });
  fs.writeFileSync(
    path.join(storage.stashDir, "commands", "review.md"),
    [
      "---",
      "name: review",
      "type: command",
      "updated: 2026-08-19",
      "agent: agents/reviewer",
      "---",
      "Review exactly: [$ARGUMENTS]",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(storage.stashDir, "agents", "reviewer.md"),
    ["---", "name: reviewer", "type: agent", "updated: 2026-08-19", "---", "You are a careful reviewer.", ""].join(
      "\n",
    ),
  );
  await akmIndex({ stashDir: storage.stashDir, full: true });
});

afterEach(() => storage.cleanup());

function stableResult(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  delete parsed.durationMs;
  return parsed;
}

describe("command CLI execution convergence", () => {
  test("command run and agent --command produce the same adapter-rendered dispatch", async () => {
    const commandFile = path.join(storage.stashDir, "commands", "review.md");
    const personaFile = path.join(storage.stashDir, "agents", "reviewer.md");
    const commandBefore = fs.readFileSync(commandFile);
    const personaBefore = fs.readFileSync(personaFile);
    const argumentInput = "  quoted 'target'\n$ARGUMENTS stays literal  ";

    const canonical = await runCliCapture([
      "command",
      "run",
      "commands/review",
      "--arguments",
      argumentInput,
      "--format=json",
      "-q",
    ]);
    const compatibility = await runCliCapture([
      "agent",
      "agents/reviewer",
      "--command",
      "commands/review",
      "--arguments",
      argumentInput,
      "--format=json",
      "-q",
    ]);

    expect(canonical.code).toBe(0);
    expect(compatibility.code).toBe(0);
    expect(stableResult(compatibility.stdout)).toEqual(stableResult(canonical.stdout));
    const result = stableResult(canonical.stdout) as { stdout: string };
    expect(result.stdout).toContain("Review exactly: [  quoted 'target'\n$ARGUMENTS stays literal  ]");
    expect(result.stdout).toContain("You are a careful reviewer.");
    expect(result.stdout).not.toContain("type: command");
    expect(result.stdout).not.toContain("type: agent");
    expect(fs.readFileSync(commandFile)).toEqual(commandBefore);
    expect(fs.readFileSync(personaFile)).toEqual(personaBefore);
  });

  test("unsupported native placeholders fail before the runner", async () => {
    const commandFile = path.join(storage.stashDir, "commands", "review.md");
    fs.writeFileSync(
      commandFile,
      "---\nname: review\ntype: command\nupdated: 2026-08-19\n---\nNever dispatch sentinel $1\n",
    );
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const result = await runCliCapture(["command", "run", "commands/review", "--format=json", "-q"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unsupported portable template construct");
    expect(result.stderr).not.toContain("Never dispatch sentinel");
  });
});
