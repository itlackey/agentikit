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
import fs from "node:fs";
import path from "node:path";
import {
  buildScheduledTaskInvocation,
  consumeSchedulerContextArg,
  schedulerContextDescriptor,
  writeSchedulerContextDescriptor,
} from "../../../src/tasks/scheduler-invocation";
import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv } from "../../_helpers/sandbox";

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
});
