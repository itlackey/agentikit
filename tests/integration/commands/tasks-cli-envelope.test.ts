// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm task` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,…} error envelope on
 * stderr / exit code) for representative subcommands, proving the extraction of
 * the family from cli.ts into src/commands/tasks-cli.ts and the migration of the
 * leaf handlers onto `defineJsonCommand` is byte-identical. Only the
 * scheduler-free subcommands are exercised (`doctor`, the bare-group default,
 * and the `run` not-found error path) so the test never touches the host OS
 * scheduler. The CLI reads an isolated stash through AKM_BUNDLE_DIR via the
 * in-process harness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import {
  buildScheduledTaskInvocation,
  consumeSchedulerContextArg,
  schedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../../../src/tasks/scheduler-invocation";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

function makeStashDir(): string {
  const d = makeSandboxDir("akm-tasks-envelope-");
  disposers.push(d);
  fs.mkdirSync(path.join(d.dir, "tasks"), { recursive: true });
  return d.dir;
}

function writeDisabledCommandTask(stashDir: string): void {
  fs.writeFileSync(
    path.join(stashDir, "tasks", "disabled-command.yml"),
    ["version: 3", "run: exit 0", "akm:", '  schedule: "@daily"', "  enabled: false", ""].join("\n"),
  );
}

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  const { code, stdout, stderr } = await withEnv({ AKM_BUNDLE_DIR: stashDir }, () => runCliCapture(args));
  return { stdout, stderr, status: code };
}

describe("akm task — JSON envelope snapshot (WS6)", () => {
  // Owner ruling 12, canonical bare-group behavior: bare `akm task` used to
  // run doctor implicitly. It is now a usage error naming the subcommands —
  // the next test covers the explicit `akm task doctor` this replaces.
  test("bare `akm task` → usage-error envelope, exit 2", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(["task"], stash);
    expect(status).toBe(2);
    const env = JSON.parse(stderr.trim());
    expect(env.ok).toBe(false);
    expect(env.code).toBe("MISSING_REQUIRED_ARGUMENT");
    expect(env.error).toContain("`akm task` requires a subcommand");
    expect(env.error).toContain("doctor");
  });

  test("tasks doctor: success envelope reports the active scheduler backend", async () => {
    const stash = makeStashDir();
    const { stdout, status } = await runCli(["task", "doctor"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.shape).toBe("task-doctor");
    expect(typeof env.backend).toBe("string");
    expect(Array.isArray(env.warnings)).toBe(true);
  });

  test("tasks run: unknown id → {ok:false} not-found envelope on stderr", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(["task", "run", "does-not-exist"], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("ASSET_NOT_FOUND");
  });

  test("tasks run manually executes an intentionally disabled task", async () => {
    const stash = makeStashDir();
    writeDisabledCommandTask(stash);

    const { stdout, status } = await runCli(["task", "run", "disabled-command"], stash);

    expect(status).toBe(0);
    expect(JSON.parse(stdout).result.status).toBe("completed");
  });

  test("a backend-generated invocation uses its captured stash and skips the disabled task", async () => {
    const capturedStash = makeStashDir();
    const ambientStash = makeStashDir();
    writeDisabledCommandTask(capturedStash);
    const generated = await withEnv({ AKM_BUNDLE_DIR: capturedStash }, () => {
      const contextPath = writeSchedulerContextDescriptor(schedulerContextDescriptor());
      return buildScheduledTaskInvocation(["akm"], "disabled-command", contextPath);
    });

    const { code, stdout, stderr } = await withEnv({ AKM_BUNDLE_DIR: ambientStash }, () => {
      const consumed = consumeSchedulerContextArg(generated.argv);
      return runCliCapture([...consumed.slice(1)]);
    });

    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout).result.status).toBe("disabled");
  });

  test.each([
    ["flat component", "."],
    ["nested component", "components/scheduled"],
  ] as const)("a real scheduled CLI invocation resolves an akm-task %s", async (_label, componentRoot) => {
    const storage = withIsolatedAkmStorage();
    const bundle = makeSandboxDir("akm-task-component");
    disposers.push(bundle);
    try {
      const taskRoot = path.join(bundle.dir, componentRoot);
      fs.mkdirSync(taskRoot, { recursive: true });
      fs.writeFileSync(
        path.join(taskRoot, "standalone.yml"),
        ["version: 3", 'run: "exit 0"', "akm:", '  schedule: "@daily"', ""].join("\n"),
      );
      saveConfig({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaultBundle: "stash",
        bundles: {
          stash: { path: storage.stashDir, writable: true },
          scheduled: {
            path: bundle.dir,
            components: { main: { root: componentRoot, adapter: "akm-task", writable: false } },
          },
        },
      });

      const { code, stdout, stderr } = await runCliCapture([
        "task",
        "run",
        "standalone",
        "--bundle",
        "scheduled",
        "--scheduled",
      ]);

      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout).result).toMatchObject({ id: "standalone", status: "completed" });
    } finally {
      storage.cleanup();
    }
  });

  test("task add help advertises --prompt as inline text only", async () => {
    const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
    const result = spawnSync("bun", [path.join(repoRoot, "src", "cli.ts"), "task", "add", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, AKM_BUNDLE_DIR: undefined },
    });
    const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status).toBe(0);
    expect(help).toMatch(/--prompt.*inline text/i);
    expect(help).not.toMatch(/--prompt.*asset ref like|--prompt.*or \.\/.*\.md/i);
  });
});
