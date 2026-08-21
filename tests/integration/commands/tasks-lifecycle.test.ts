// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksAdd, akmTasksSync, setEnabledInYaml } from "../../../src/commands/tasks/tasks";
import type { TaskBackend } from "../../../src/tasks/backends/types";
import type { ScheduleBackend } from "../../../src/tasks/schedule";
import type { SchedulerBinding } from "../../../src/tasks/scheduler-binding";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let backendName: ScheduleBackend;
let installed: Map<string, SchedulerBinding | undefined>;
let installCalls: SchedulerBinding[];
let enabledCalls: Array<{ id: string; enabled: boolean }>;
let uninstallCalls: string[];
let failInstall: ((task: SchedulerBinding) => boolean) | undefined;
let setEnabledError: Error | undefined;
let uninstallError: Error | undefined;

function nativeBinding(id: string, cron: string, enabled = true): SchedulerBinding {
  return {
    id,
    logicalSource: { kind: "task", ref: `stash//tasks/${id}` },
    cron,
    source: "akm.schedule",
    ordinal: 0,
    enabled,
    invocation: ["task", "run", id, "--scheduled"],
  };
}

const backend: TaskBackend = {
  get name() {
    return backendName;
  },
  install(task) {
    installCalls.push(task);
    if (failInstall?.(task)) throw new Error(`install failed for ${task.id}`);
    installed.set(task.id, task);
  },
  uninstall(id) {
    uninstallCalls.push(id);
    if (uninstallError) throw uninstallError;
    installed.delete(id);
  },
  setEnabled(id, enabled) {
    enabledCalls.push({ id, enabled });
    if (setEnabledError) throw setEnabledError;
    const task = installed.get(id);
    if (task) installed.set(id, { ...task, enabled });
  },
  list() {
    return [...installed.keys()].map((id) => ({
      id,
      binding: ["/test/akm"],
      contextPath: "/test/context.json",
    }));
  },
};

function writeTask(id: string, yaml: string): string {
  const filePath = path.join(storage.stashDir, "tasks", `${id}.yml`);
  fs.writeFileSync(filePath, yaml, "utf8");
  return filePath;
}

function taskYaml(run: string, schedule: string, enabled = true, name?: string): string {
  return [
    "version: 3",
    `run: ${run}`,
    ...(name ? [`name: ${name}`] : []),
    "akm:",
    `  schedule: "${schedule}"`,
    `  enabled: ${enabled}`,
  ].join("\n");
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeSandboxConfig({
    bundles: { stash: { path: storage.stashDir, writable: true } },
    defaultBundle: "stash",
  });
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  backendName = "cron";
  installed = new Map();
  installCalls = [];
  enabledCalls = [];
  uninstallCalls = [];
  failInstall = undefined;
  setEnabledError = undefined;
  uninstallError = undefined;
});

afterEach(() => {
  storage.cleanup();
});

describe("task lifecycle failure handling", () => {
  test("setup-style enable edits stay inside the v3 akm mapping", () => {
    const yaml = "version: 3\nrun: echo yes\nakm:\n  schedule: '@daily'\n  enabled: true # keep\n";
    expect(setEnabledInYaml(yaml, false)).toBe(
      "version: 3\nrun: echo yes\nakm:\n  schedule: '@daily'\n  enabled: false # keep\n",
    );
    expect(setEnabledInYaml("version: 3\nrun: echo yes\n", false)).toBe(
      "version: 3\nrun: echo yes\nakm:\n  enabled: false\n",
    );
  });

  // Issue 11: a workflow task's `timeoutMs` is its whole-run bound (the task
  // runner turns it into the abort signal `akm workflow run --timeout` uses),
  // so `--timeout-ms` is no longer refused alongside `--workflow`. Engine and
  // model stay prompt-only — a workflow's engines come from its frozen plan.
  test("add accepts --timeout-ms on a workflow task and records it in the YAML", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, "nightly.md"), "# Nightly\n", "utf8");

    const result = await akmTasksAdd(
      { id: "nightly-wf", schedule: "@daily", workflow: "workflows/nightly", timeoutMs: 900_000 },
      { backend },
    );

    expect(result.target).toMatchObject({ kind: "uses", uses: { kind: "workflow", ref: "workflows/nightly" } });
    expect(fs.readFileSync(result.path, "utf8")).toContain("timeout: 900000");
  });

  test("add still refuses --engine on a workflow task", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, "nightly.md"), "# Nightly\n", "utf8");

    await expect(
      akmTasksAdd(
        { id: "nightly-engine", schedule: "@daily", workflow: "workflows/nightly", engine: "reviewer" },
        { backend },
      ),
    ).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
  });

  test("add rejects a recognized remote action before source or scheduler mutation", async () => {
    await expect(
      akmTasksAdd({ id: "remote", schedule: "@daily", workflow: "owner/repository/action@v1" }, { backend }),
    ).rejects.toThrow(/remote GitHub actions/);
    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "remote.yml"))).toBe(false);
    expect(installCalls).toEqual([]);
  });

  test("add refuses to shadow a legacy markdown task without --force", async () => {
    const legacyPath = path.join(storage.stashDir, "tasks", "nightly.md");
    fs.writeFileSync(legacyPath, "---\nschedule: '@daily'\n---\nLegacy task\n", "utf8");

    await expect(
      akmTasksAdd(
        {
          id: "nightly",
          schedule: "@daily",
          command: "echo replacement",
        },
        { backend },
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_ALREADY_EXISTS" });

    expect(fs.existsSync(path.join(storage.stashDir, "tasks", "nightly.yml"))).toBe(false);
    expect(installCalls).toEqual([]);
  });

  test("sync rejects an invalid filesystem-derived id without mutating its installed definition", async () => {
    writeTask("manual task", taskYaml("echo unsafe", "@daily"));
    installed.set("manual task", undefined);

    await expect(akmTasksSync({ backend })).rejects.toThrow('Task id "manual task" is invalid');
    expect(enabledCalls).toEqual([]);
    expect(installCalls).toEqual([]);
  });

  test("sync rejects an unsupported schedule without mutating its installed definition", async () => {
    backendName = "schtasks";
    writeTask("monthly", taskYaml("echo monthly", "0 0 1 * *"));
    installed.set("monthly", undefined);

    await expect(akmTasksSync({ backend })).rejects.toThrow(/unsupported|schedule/i);
    expect(enabledCalls).toEqual([]);
    expect(installCalls).toEqual([]);
  });

  test("sync validates the entire desired set before runtime preparation or native mutation", async () => {
    writeTask("a-valid", taskYaml("echo yes", "@daily"));
    writeTask("b-invalid", 'version: 2\nschedule: "@daily"\ncommand: echo no\n');
    const prior = nativeBinding("old-installed", "0 2 * * *");
    installed.set(prior.id, prior);
    let runtimeCalls = 0;

    await expect(
      akmTasksSync({
        backend,
        schedulerRuntime() {
          runtimeCalls += 1;
          return { binding: ["/test/akm"], contextPath: "/test/context.json" };
        },
      }),
    ).rejects.toThrow(/version must be exactly 3|version 2/i);

    expect(runtimeCalls).toBe(0);
    expect(installCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
    expect(enabledCalls).toEqual([]);
    expect(installed).toEqual(new Map([[prior.id, prior]]));
  });

  test("add --force trusts a rejected install to preserve prior scheduler state and restores only source", async () => {
    const priorYaml = [
      "version: 3",
      "run: echo prior",
      "name: Prior task",
      "akm:",
      '  schedule: "0 2 * * *"',
      "  enabled: false",
    ].join("\n");
    const taskPath = writeTask("nightly", priorYaml);
    const priorTask = nativeBinding("nightly", "0 2 * * *", false);
    installed.set("nightly", priorTask);
    failInstall = (task) => task.cron === "0 3 * * *";

    await expect(
      akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        { backend },
      ),
    ).rejects.toThrow("install failed for nightly");

    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls.map((task) => ({ schedule: task.cron, enabled: task.enabled }))).toEqual([
      { schedule: "0 3 * * *", enabled: true },
    ]);
    expect(enabledCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
    expect(installed.get("nightly")).toMatchObject({ cron: "0 2 * * *", enabled: false });
  });

  test("add does not uninstall an orphaned prior scheduler entry when replacement install rejects", async () => {
    const taskPath = path.join(storage.stashDir, "tasks", "orphaned.yml");
    installed.set("orphaned", nativeBinding("orphaned", "0 2 * * *"));
    failInstall = (task) => task.cron === "0 3 * * *";

    await expect(
      akmTasksAdd(
        {
          id: "orphaned",
          schedule: "0 3 * * *",
          command: "echo replacement",
        },
        { backend },
      ),
    ).rejects.toThrow("install failed for orphaned");

    expect(fs.existsSync(taskPath)).toBe(false);
    expect(installCalls.map((task) => task.cron)).toEqual(["0 3 * * *"]);
    expect(enabledCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
    expect(installed.get("orphaned")).toMatchObject({ cron: "0 2 * * *", enabled: true });
  });

  test("add --force restores exact prior bytes after a partial source write throws", async () => {
    const priorYaml = [
      "version: 3",
      "run: echo prior",
      "akm:",
      '  schedule: "0 2 * * *"',
      "  enabled: true # exact prior bytes",
    ].join("\n");
    const taskPath = writeTask("nightly", priorYaml);
    let writeCalls = 0;

    await expect(
      akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        {
          backend,
          async writeAsset(_source, _config, ref, content) {
            writeCalls += 1;
            if (writeCalls === 1) {
              fs.writeFileSync(taskPath, "version: 3\nrun:", "utf8");
              throw new Error("partial source write failed");
            }
            fs.writeFileSync(taskPath, content, "utf8");
            return { path: taskPath, ref: `${ref.type}:${ref.name}` };
          },
        },
      ),
    ).rejects.toThrow("partial source write failed");

    expect(writeCalls).toBe(2);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
  });

  test("add removes a newly created partial source file when its write throws", async () => {
    const taskPath = path.join(storage.stashDir, "tasks", "partial.yml");
    let deleteCalls = 0;

    await expect(
      akmTasksAdd(
        {
          id: "partial",
          schedule: "@daily",
          command: "echo partial",
        },
        {
          backend,
          async writeAsset() {
            fs.writeFileSync(taskPath, "version: 3\nrun:", "utf8");
            throw new Error("partial source write failed");
          },
          async deleteAsset(_source, _config, ref) {
            deleteCalls += 1;
            fs.unlinkSync(taskPath);
            return { path: taskPath, ref: `${ref.type}:${ref.name}` };
          },
        },
      ),
    ).rejects.toThrow("partial source write failed");

    expect(deleteCalls).toBe(1);
    expect(fs.existsSync(taskPath)).toBe(false);
    expect(installCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
  });

  test("add does not compensate an unmutated source when its write rejects before creating a file", async () => {
    const taskPath = path.join(storage.stashDir, "tasks", "unwritten.yml");
    let deleteCalls = 0;
    let failure: unknown;

    try {
      await akmTasksAdd(
        {
          id: "unwritten",
          schedule: "@daily",
          command: "echo unwritten",
        },
        {
          backend,
          async writeAsset() {
            throw new Error("source write rejected");
          },
          async deleteAsset() {
            deleteCalls += 1;
            throw new Error("unexpected source delete");
          },
        },
      );
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toBe("source write rejected");
    expect(deleteCalls).toBe(0);
    expect(fs.existsSync(taskPath)).toBe(false);
    expect(installCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
  });

  test("install rejection aggregates source rollback failure without touching a valid prior entry", async () => {
    const priorYaml = `${taskYaml("echo prior", "0 2 * * *")}\n`;
    const taskPath = writeTask("nightly", priorYaml);
    installed.set("nightly", nativeBinding("nightly", "0 2 * * *"));
    failInstall = () => true;
    let writeCalls = 0;
    let failure: unknown;

    try {
      await akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        {
          backend,
          async writeAsset(_source, _config, ref, content) {
            writeCalls += 1;
            if (writeCalls === 2) throw new Error("source restore failed");
            fs.writeFileSync(taskPath, content, "utf8");
            return { path: taskPath, ref: `${ref.type}:${ref.name}` };
          },
        },
      );
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
      "Error: install failed for nightly",
      "Error: source restore failed",
    ]);
    expect(installCalls.map((task) => task.cron)).toEqual(["0 3 * * *"]);
    expect(enabledCalls).toEqual([]);
    expect(uninstallCalls).toEqual([]);
    expect(installed.get("nightly")).toMatchObject({ cron: "0 2 * * *", enabled: true });
  });

  test("commit failure disables the replacement when restoring the prior scheduler definition fails", async () => {
    const priorYaml = `${taskYaml("echo prior", "0 2 * * *")}\n`;
    const taskPath = writeTask("nightly", priorYaml);
    installed.set("nightly", nativeBinding("nightly", "0 2 * * *"));
    failInstall = (task) => task.cron === "0 2 * * *";
    let commitCalls = 0;
    let failure: unknown;

    try {
      await akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        {
          backend,
          commitBoundary() {
            commitCalls += 1;
            if (commitCalls === 1) throw new Error("commit boundary failed");
          },
        },
      );
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
      "Error: commit boundary failed",
      "Error: install failed for nightly",
    ]);
    expect(commitCalls).toBe(2);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls.map((task) => task.cron)).toEqual(["0 3 * * *", "0 2 * * *"]);
    expect(enabledCalls).toEqual([{ id: "nightly", enabled: false }]);
    expect(uninstallCalls).toEqual([]);
    expect(installed.get("nightly")).toMatchObject({ cron: "0 3 * * *", enabled: false });
  });

  test("commit failure uninstalls the replacement and aggregates a failed fail-safe disable", async () => {
    const priorYaml = `${taskYaml("echo prior", "0 2 * * *")}\n`;
    const taskPath = writeTask("nightly", priorYaml);
    installed.set("nightly", nativeBinding("nightly", "0 2 * * *"));
    failInstall = (task) => task.cron === "0 2 * * *";
    setEnabledError = new Error("disable failed for nightly");
    let commitCalls = 0;
    let failure: unknown;

    try {
      await akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        {
          backend,
          commitBoundary() {
            commitCalls += 1;
            if (commitCalls === 1) throw new Error("commit boundary failed");
          },
        },
      );
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
      "Error: commit boundary failed",
      "Error: install failed for nightly",
      "Error: disable failed for nightly",
    ]);
    expect(commitCalls).toBe(2);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls.map((task) => task.cron)).toEqual(["0 3 * * *", "0 2 * * *"]);
    expect(enabledCalls).toEqual([{ id: "nightly", enabled: false }]);
    expect(uninstallCalls).toEqual(["nightly"]);
    expect(installed.has("nightly")).toBe(false);
  });

  test("add --force restores the prior definition and installed state when the commit boundary fails", async () => {
    const priorYaml = `${taskYaml("echo prior", "0 2 * * *", false)}\n`;
    const taskPath = writeTask("nightly", priorYaml);
    installed.set("nightly", nativeBinding("nightly", "0 2 * * *", false));
    let commitCalls = 0;

    await expect(
      akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 3 * * *",
          command: "echo replacement",
          force: true,
        },
        {
          backend,
          commitBoundary() {
            commitCalls += 1;
            if (commitCalls === 1) throw new Error("commit boundary failed");
          },
        },
      ),
    ).rejects.toThrow("commit boundary failed");

    expect(commitCalls).toBe(2);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(priorYaml);
    expect(installCalls.map((task) => ({ schedule: task.cron, enabled: task.enabled }))).toEqual([
      { schedule: "0 3 * * *", enabled: true },
      { schedule: "0 2 * * *", enabled: false },
    ]);
    expect(installed.get("nightly")).toMatchObject({ cron: "0 2 * * *", enabled: false });
  });

  test("sync installs command arguments without obsolete-command handling", async () => {
    const yaml = ["version: 3", "run: akm db backups", "akm:", '  schedule: "0 3 * * 0"', "  enabled: true", ""].join(
      "\n",
    );
    writeTask("backup", yaml);

    const result = await akmTasksSync({ backend });

    expect(result.installed).toEqual(["backup"]);
    expect(result.skipped).toEqual([]);
    expect(installCalls[0]?.logicalSource).toEqual({ kind: "task", ref: "stash//tasks/backup" });
    expect(installCalls[0]?.invocation).toEqual(["task", "run", "backup", "--scheduled"]);
  });

  test("add rejects argv arrays instead of silently joining them", async () => {
    await expect(
      akmTasksAdd(
        {
          id: "backup",
          schedule: "0 3 * * 0",
          command: ["akm", "db", "backups"],
        },
        { backend },
      ),
    ).rejects.toThrow(/shell string|argv arrays/i);
    expect(installCalls).toHaveLength(0);
  });
});
