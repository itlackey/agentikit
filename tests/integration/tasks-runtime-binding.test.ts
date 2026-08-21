import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmTasksAdd, akmTasksDoctor, akmTasksSync, prepareSchedulerRuntime } from "../../src/commands/tasks/tasks";
import type { TaskBackend, TaskInstallOptions } from "../../src/tasks/backends/types";
import { schedulerContextDescriptor, writeSchedulerContextDescriptor } from "../../src/tasks/scheduler-invocation";
import { withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

function writeTask(stashDir: string): void {
  fs.mkdirSync(path.join(stashDir, "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(stashDir, "tasks", "ping.yml"),
    'version: 3\nrun: echo ping\nakm:\n  schedule: "@daily"\n',
  );
}

function configureStash(stashDir: string): void {
  writeSandboxConfig({ bundles: { stash: { path: stashDir, writable: true } }, defaultBundle: "stash" });
}

describe("scheduler runtime binding", () => {
  test("source creation refuses without explicit rebind", () => {
    const storage = withIsolatedAkmStorage();
    const sourceCandidate = () => ({
      argv: ["/usr/bin/bun", "/repo/src/cli.ts"],
      via: "checkout" as const,
      kind: "checkout" as const,
      eligible: false,
    });

    try {
      expect(() =>
        prepareSchedulerRuntime(false, "create scheduler entry", {
          resolveInvocation: sourceCandidate,
          writeDescriptor: () => "/unused/context.json",
        }),
      ).toThrow("Refusing to create scheduler entry from an ineligible checkout invocation");
      const packageLocalError = (() => {
        try {
          prepareSchedulerRuntime(false, "create scheduler entry", {
            resolveInvocation: () => ({
              argv: ["/usr/bin/node", "/project/node_modules/akm-cli/dist/akm"],
              via: "package-local",
              kind: "package-local",
              eligible: false,
            }),
            writeDescriptor: () => "/unused/context.json",
          });
        } catch (error) {
          return error;
        }
        throw new Error("expected package-local scheduler binding to be refused");
      })() as Error & { hint(): string | undefined };
      expect(packageLocalError.message).toContain("ineligible package-local invocation");
      expect(packageLocalError.hint()).toContain("npm-global ownership could not be verified");
      expect(
        prepareSchedulerRuntime(true, "create scheduler entry", {
          resolveInvocation: sourceCandidate,
          writeDescriptor: () => "/data/context.json",
        }),
      ).toEqual({
        binding: ["/usr/bin/bun", "/repo/src/cli.ts"],
        contextPath: "/data/context.json",
        eligible: false,
        kind: "checkout",
      });
    } finally {
      storage.cleanup();
    }
  });

  test("ordinary sync preserves binding and --rebind replaces it", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      const installs: Array<TaskInstallOptions | undefined> = [];
      const backend: TaskBackend = {
        name: "cron",
        install(_task, options) {
          installs.push(options);
        },
        uninstall() {},
        setEnabled() {},
        list: () => [
          {
            id: "ping",
            signature: "installed",
            binding: ["/old/node", "/old/dist/akm"],
            contextPath: "/old/context.json",
          },
        ],
        expectedSignature: () => "expected",
      };

      await akmTasksSync({ backend });
      expect(installs[0]).toMatchObject({
        binding: ["/old/node", "/old/dist/akm"],
        contextPath: "/old/context.json",
      });

      await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({ binding: ["/new/node", "/new/dist/akm"], contextPath: "/new/context.json" }),
        },
        undefined,
        { rebind: true },
      );
      expect(installs[1]).toMatchObject({
        binding: ["/new/node", "/new/dist/akm"],
        contextPath: "/new/context.json",
      });
    } finally {
      storage.cleanup();
    }
  });

  test("sync --rebind warns once when the resolved runtime is ineligible", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      const backend: TaskBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [
          {
            id: "ping",
            signature: "installed",
            binding: ["/old/node", "/old/dist/akm"],
            contextPath: "/old/context.json",
          },
        ],
        expectedSignature: () => "expected",
      };

      const result = await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({
            binding: ["/repo/bun", "/repo/src/cli.ts"],
            contextPath: "/new/context.json",
            eligible: false,
            kind: "checkout",
          }),
        },
        undefined,
        { rebind: true },
      );

      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings?.[0]).toContain("ineligible checkout invocation");
      expect(result.warnings?.[0]).toContain("/repo/bun /repo/src/cli.ts");
      expect(result.warnings?.[0]).toContain("--rebind");
    } finally {
      storage.cleanup();
    }
  });

  test("sync --rebind emits no warning when the resolved runtime is eligible", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      const backend: TaskBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [
          {
            id: "ping",
            signature: "installed",
            binding: ["/old/node", "/old/dist/akm"],
            contextPath: "/old/context.json",
          },
        ],
        expectedSignature: () => "expected",
      };

      const result = await akmTasksSync(
        {
          backend,
          schedulerRuntime: () => ({
            binding: ["/usr/local/bin/node", "/usr/local/lib/node_modules/akm-cli/dist/akm"],
            contextPath: "/new/context.json",
            eligible: true,
            kind: "npm",
          }),
        },
        undefined,
        { rebind: true },
      );

      expect(result.warnings).toBeUndefined();
    } finally {
      storage.cleanup();
    }
  });

  test("add --force never replaces an existing binding", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      const installs: Array<TaskInstallOptions | undefined> = [];
      const backend: TaskBackend = {
        name: "cron",
        install(_task, options) {
          installs.push(options);
        },
        uninstall() {},
        setEnabled() {},
        list: () => [
          {
            id: "ping",
            binding: ["/old/node", "/old/dist/akm"],
            contextPath: "/old/context.json",
          },
        ],
      };

      await akmTasksAdd(
        { id: "ping", schedule: "@daily", command: "echo ping", force: true, rebind: true },
        {
          backend,
          schedulerRuntime: () => ({ binding: ["/new/node", "/new/dist/akm"], contextPath: "/new/context.json" }),
        },
      );

      expect(installs[0]).toMatchObject({
        binding: ["/old/node", "/old/dist/akm"],
        contextPath: "/old/context.json",
      });
    } finally {
      storage.cleanup();
    }
  });

  test("a file-edit reinstall uses the current binding and descriptor", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      configureStash(storage.stashDir);
      writeTask(storage.stashDir);
      // The enable/disable mutation API was removed in 0.9 (S6.3) — flipping a
      // task's `enabled:` field is now a plain file edit, reconciled by sync.
      fs.writeFileSync(
        path.join(storage.stashDir, "tasks", "ping.yml"),
        'version: 3\nrun: echo ping\nakm:\n  schedule: "@daily"\n  enabled: false\n',
      );
      const installs: Array<TaskInstallOptions | undefined> = [];
      const backend: TaskBackend = {
        name: "cron",
        install(_task, options) {
          installs.push(options);
        },
        uninstall() {},
        setEnabled() {},
        list: () => [{ id: "ping", binding: ["/current/akm"], contextPath: "/current/context.json" }],
      };

      await akmTasksSync({
        backend,
        schedulerRuntime: () => {
          throw new Error("must not derive caller binding");
        },
      });
      expect(installs).toEqual([{ binding: ["/current/akm"], contextPath: "/current/context.json" }]);
    } finally {
      storage.cleanup();
    }
  });

  test("doctor groups current backend bindings and reports remediation for unhealthy bindings", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      fs.mkdirSync(storage.stashDir, { recursive: true });
      const contextPath = writeSchedulerContextDescriptor(schedulerContextDescriptor());
      const tamperedContextPath = writeSchedulerContextDescriptor(
        schedulerContextDescriptor(undefined, `${process.env.PATH ?? ""}${path.delimiter}/tampered`),
      );
      fs.writeFileSync(
        tamperedContextPath,
        fs.readFileSync(tamperedContextPath, "utf8").replace("/tampered", "/modified"),
        { mode: 0o600 },
      );
      const backend: TaskBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [
          { id: "alpha", binding: [process.execPath], contextPath },
          { id: "beta", binding: [process.execPath], contextPath },
          { id: "tampered", binding: [process.execPath], contextPath: tamperedContextPath },
        ],
      };
      const result = await akmTasksDoctor({
        backend,
        resolveInvocation: () => ({
          argv: [process.execPath],
          via: "standalone",
          kind: "standalone",
          eligible: true,
        }),
      });

      expect(result.bindings).toContainEqual({
        argv: [process.execPath],
        contextPath,
        taskIds: ["alpha", "beta"],
        status: ["ok"],
      });
      expect(result.bindings).toContainEqual({
        argv: [process.execPath],
        contextPath: tamperedContextPath,
        taskIds: ["tampered"],
        status: ["invalid-context"],
      });
      expect(result.caller.kind).toBe("standalone");
      expect(result.remediation).toBe("akm task sync --rebind");
    } finally {
      storage.cleanup();
    }
  });

  test("doctor trusts an eligible npm binding over the checkout path heuristic", async () => {
    const storage = withIsolatedAkmStorage();
    try {
      fs.mkdirSync(storage.stashDir, { recursive: true });
      const contextPath = writeSchedulerContextDescriptor(schedulerContextDescriptor());
      // This path has a Git ancestor, matching an npm launcher that resolves through a linked checkout.
      const argv = [
        process.execPath,
        path.join(process.cwd(), "tests", "integration", "tasks-runtime-binding.test.ts"),
      ];
      const backend: TaskBackend = {
        name: "cron",
        install() {},
        uninstall() {},
        setEnabled() {},
        list: () => [{ id: "stable", binding: argv, contextPath }],
      };

      const result = await akmTasksDoctor({
        backend,
        resolveInvocation: () => ({ argv, via: "npm", kind: "npm", eligible: true }),
      });

      expect(result.bindings).toEqual([{ argv, contextPath, taskIds: ["stable"], status: ["ok"] }]);
      expect(result.remediation).toBeUndefined();
    } finally {
      storage.cleanup();
    }
  });
});
