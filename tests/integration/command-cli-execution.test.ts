// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

function treeSnapshot(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const stat = fs.statSync(absolute);
        out.push(
          `${relative}:${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`,
        );
      }
    }
  };
  visit(root);
  return out;
}

async function installHostileInferenceKey(): Promise<void> {
  fs.writeFileSync(
    path.join(storage.stashDir, "commands", "review.md"),
    [
      "---",
      "name: review",
      "type: command",
      "updated: 2026-08-19",
      "agent: agents/reviewer",
      "akm:",
      "  inference:",
      "    DO-NOT-LEAK-secret-key: ordinary-value",
      "    another-user-defined-key: another-value",
      "---",
      "Review exactly: [$ARGUMENTS]",
      "",
    ].join("\n"),
  );
  await akmIndex({ stashDir: storage.stashDir, full: true });
}

describe("command CLI execution convergence", () => {
  test("command run --dry-run authorizes and lowers without dispatch, credentials, usage, or persistent writes", async () => {
    writeSandboxConfig({
      engines: {
        direct: {
          kind: "llm",
          endpoint: "https://DO-NOT-LEAK.invalid/v1/chat/completions",
          model: "DO-NOT-LEAK-model",
          apiKey: "$AKM_REQUIRED_DRY_RUN_SECRET",
        },
      },
      defaults: { engine: "direct" },
    });
    delete process.env.AKM_REQUIRED_DRY_RUN_SECRET;
    const before = treeSnapshot(storage.root);

    const result = await runCliCapture([
      "command",
      "run",
      "commands/review",
      "--dry-run",
      "--cwd",
      "/DO-NOT-LEAK/workspace",
      "--format=json",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      shape: "command-dry-run",
      ok: true,
      dryRun: true,
      engine: "direct",
    });
    expect(envelope).not.toHaveProperty("exitCode");
    expect(envelope).not.toHaveProperty("stdout");
    expect(envelope).not.toHaveProperty("stderr");
    expect(envelope).not.toHaveProperty("durationMs");
    expect(JSON.stringify(envelope)).not.toContain("DO-NOT-LEAK");
    expect(treeSnapshot(storage.root)).toEqual(before);
  });

  test("live --verbose reports only safe dry-run diagnostics before preserving the dispatch envelope", async () => {
    const ordinary = await runCliCapture([
      "command",
      "run",
      "commands/review",
      "--arguments",
      "private argument",
      "--format=json",
    ]);
    const verbose = await runCliCapture([
      "command",
      "run",
      "commands/review",
      "--arguments",
      "private argument",
      "--verbose",
      "--format=json",
    ]);

    expect(ordinary.code).toBe(0);
    expect(verbose.code).toBe(0);
    expect(stableResult(verbose.stdout)).toEqual(stableResult(ordinary.stdout));
    expect(ordinary.stderr).toBe("");
    expect(verbose.stderr).toContain("[akm:command] diagnostics ");
    expect(verbose.stderr).toContain('"provenance"');
    expect(verbose.stderr).toContain('"notices"');
    expect(verbose.stderr).not.toContain("private argument");
    expect(verbose.stderr).not.toContain("Review exactly");
    expect(verbose.stderr).not.toContain(storage.stashDir);
  });

  test("command run --dry-run canonicalizes user-authored inference keys in provenance and notices", async () => {
    await installHostileInferenceKey();

    const result = await runCliCapture(["command", "run", "commands/review", "--dry-run", "--format=json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout) as {
      provenance: Array<{ field: string }>;
      notices: Array<{ field?: string; message: string }>;
    };
    expect(envelope.provenance.map(({ field }) => field).filter((field) => field === "/inference/*")).toHaveLength(1);
    expect(envelope.notices.map(({ field }) => field).filter((field) => field === "inference.*")).toHaveLength(1);
    expect(JSON.stringify(envelope.provenance)).not.toContain("DO-NOT-LEAK-secret-key");
    expect(JSON.stringify(envelope.notices)).not.toContain("DO-NOT-LEAK-secret-key");
  });

  test("command run --verbose canonicalizes user-authored inference keys in stderr diagnostics", async () => {
    await installHostileInferenceKey();

    const result = await runCliCapture(["command", "run", "commands/review", "--verbose", "--format=json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('"field":"/inference/*"');
    expect(result.stderr).toContain('"field":"inference.*"');
    expect(result.stderr).not.toContain("DO-NOT-LEAK-secret-key");
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
