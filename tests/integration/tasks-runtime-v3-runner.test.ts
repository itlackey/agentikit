import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { SpawnFn } from "../../src/core/subprocess";
import { readTaskHistory, runTask } from "../../src/tasks/runner";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let tasksDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tasksDir = path.join(storage.stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  writeSandboxConfig({
    bundles: { fixture: { path: storage.stashDir, writable: true } },
    defaultBundle: "fixture",
    semanticSearchMode: "off",
  });
});

afterEach(() => storage.cleanup());

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

function logFiles(): string[] {
  const root = path.join(storage.cacheDir, "akm", "tasks", "logs");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).map(String);
}

describe("task-v3 runner mutation boundary", () => {
  for (const [label, yaml, message] of [
    ["v2", 'version: 2\nschedule: "@daily"\ncommand: echo legacy\n', "TASK_SCHEMA_VERSION_UNSUPPORTED"],
    ["malformed", 'version: 3\nrun: [unterminated\nakm:\n  schedule: "@daily"\n', "Invalid task v3"],
    ["remote action", 'version: 3\nuses: actions/checkout@v4\nakm:\n  schedule: "@daily"\n', "unsupported"],
    ["unresolved", 'version: 3\nuses: scripts/missing.sh\nakm:\n  schedule: "@daily"\n', "not found"],
    [
      "nonprojectable command parameters",
      'version: 3\nuses: commands/missing\nwith:\n  value: no\nakm:\n  schedule: "@daily"\n',
      "do not accept with",
    ],
    [
      "secret-shaped literal env",
      'version: 3\nrun: printf no\nenv:\n  API_TOKEN: github_pat_012345678901234567890123456789\nakm:\n  schedule: "@daily"\n',
      "secret-shaped literal env",
    ],
    [
      "unresolved engine",
      'version: 3\nuses: akm/command\nwith:\n  content: Review\nakm:\n  schedule: "@daily"\n  engine: missing\n',
      "missing",
    ],
  ] as const) {
    test(`${label} source fails before any history or log mutation`, async () => {
      writeTask("blocked", yaml);
      let failure: unknown;
      try {
        await runTask("blocked", { stashDir: storage.stashDir, bundleName: "fixture", scheduled: true });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(message);
      if (label === "v2") {
        expect((failure as Error & { hint(): string }).hint()).toContain("akm migrate apply --dry-run");
      }
      expect(readTaskHistory({ id: "blocked" })).toEqual([]);
      expect(logFiles()).toEqual([]);
    });
  }

  test("a post-dispatch nonzero shell result records exactly one failed attempt", async () => {
    writeTask("fails", 'version: 3\nrun: exit 7\nshell: sh\nakm:\n  schedule: "@daily"\n');
    const result = await runTask("fails", {
      stashDir: storage.stashDir,
      bundleName: "fixture",
      scheduled: true,
    });
    expect(result).toMatchObject({ status: "failed", target: { kind: "command" }, detail: { exitCode: 7 } });
    expect(readTaskHistory({ id: "fails" })).toHaveLength(1);
    expect(logFiles().some((file) => file.endsWith(".log"))).toBe(true);
  });

  test("a multi-job workflow target fails the 0.9.2 runtime boundary before attempt reservation", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "multi.yml"),
      [
        "name: Multi",
        "on:",
        "  workflow_dispatch: {}",
        "jobs:",
        "  first:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: one",
        "        run: echo one",
        "  second:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: two",
        "        run: echo two",
        "",
      ].join("\n"),
    );
    writeTask("multi", 'version: 3\nuses: workflows/multi\nakm:\n  schedule: "@daily"\n');

    await expect(
      runTask("multi", { stashDir: storage.stashDir, bundleName: "fixture", scheduled: true }),
    ).rejects.toThrow(/single-job|multi-job/i);
    expect(readTaskHistory({ id: "multi" })).toEqual([]);
    expect(logFiles()).toEqual([]);
  });

  test("unsupported workflow services fail before attempt reservation", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "services.yml"),
      [
        "name: Services",
        "on:",
        "  workflow_dispatch: {}",
        "jobs:",
        "  only:",
        "    runs-on: [self-hosted]",
        "    services:",
        "      database:",
        "        image: postgres:latest",
        "    steps:",
        "      - id: one",
        "        run: echo one",
        "",
      ].join("\n"),
    );
    writeTask("services", 'version: 3\nuses: workflows/services\nakm:\n  schedule: "@daily"\n');

    await expect(
      runTask("services", { stashDir: storage.stashDir, bundleName: "fixture", scheduled: true }),
    ).rejects.toThrow(/services/i);
    expect(readTaskHistory({ id: "services" })).toEqual([]);
    expect(logFiles()).toEqual([]);
  });

  test("a bundle-qualified script resolves from the named configured bundle", async () => {
    const shared = path.join(storage.root, "shared-bundle");
    fs.mkdirSync(path.join(shared, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(shared, "scripts", "ok.sh"), "#!/bin/sh\nprintf qualified\n");
    writeSandboxConfig({
      bundles: {
        fixture: { path: storage.stashDir, writable: true },
        shared: { path: shared, writable: false },
      },
      defaultBundle: "fixture",
      semanticSearchMode: "off",
    });
    writeTask("qualified", 'version: 3\nuses: shared//scripts/ok.sh\nakm:\n  schedule: "@daily"\n');

    const result = await runTask("qualified", {
      stashDir: storage.stashDir,
      bundleName: "fixture",
      scheduled: true,
    });
    expect(result).toMatchObject({ status: "completed", target: { kind: "command" } });
    expect(fs.readFileSync(result.log, "utf8")).toContain("qualified");
    expect(readTaskHistory({ id: "qualified" })).toHaveLength(1);
  });

  test("run dispatch preserves the exact authored shell string, cwd, and scalar env", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "work"));
    const command = `printf '%s' "a b"`;
    writeTask(
      "exact-shell",
      [
        "version: 3",
        `run: ${JSON.stringify(command)}`,
        "shell: zsh",
        "working-directory: work",
        "env:",
        "  COUNT: 0",
        "  ENABLED: false",
        "akm:",
        '  schedule: "@daily"',
        "",
      ].join("\n"),
    );
    let observed: { cmd: string[]; cwd?: string; env?: Record<string, string> } | undefined;
    const spawnFn: SpawnFn = (cmd, options) => {
      observed = { cmd, cwd: options.cwd, env: options.env };
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stdin: null,
        kill() {},
      };
    };

    const result = await runTask("exact-shell", {
      stashDir: storage.stashDir,
      bundleName: "fixture",
      spawnFn,
    });
    expect(result.status).toBe("completed");
    expect(observed?.cmd).toEqual(["zsh", "-c", command]);
    expect(observed?.cwd).toBe(path.join(storage.stashDir, "work"));
    expect(observed?.env).toMatchObject({ COUNT: "0", ENABLED: "false", AKM_EVENT_SOURCE: "task" });
  });
});
