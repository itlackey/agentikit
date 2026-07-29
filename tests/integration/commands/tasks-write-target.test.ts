// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import * as tasksModule from "../../../src/commands/tasks/tasks";
import { saveConfig } from "../../../src/core/config/config";
import type { TaskBackend } from "../../../src/tasks/backends/types";
import { makeSandboxDir, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const backendState = {
  installCalls: [] as string[],
  uninstallCalls: [] as string[],
  failInstallFor: new Set<string>(),
};

function resetBackendState(): void {
  backendState.installCalls = [];
  backendState.uninstallCalls = [];
  backendState.failInstallFor.clear();
}

const fakeBackend: TaskBackend = {
  name: "cron",
  install: async (task) => {
    backendState.installCalls.push(task.id);
    if (backendState.failInstallFor.has(task.id)) throw new Error(`install failed for ${task.id}`);
  },
  uninstall: async (id) => {
    backendState.uninstallCalls.push(id);
  },
  setEnabled: async () => {},
  list: async () => [],
};

afterEach(() => {
  resetBackendState();
});

describe("task asset mutations honor write-target resolution", () => {
  test("rejects a writable OKF target before writing or installing a task", async () => {
    const iso = withIsolatedAkmStorage();
    const target = makeSandboxDir("akm-task-okf-target");
    try {
      saveConfig({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaultWriteTarget: "target",
        bundles: {
          target: {
            path: target.dir,
            components: { main: { root: ".", adapter: "okf", writable: true } },
          },
        },
      });

      await expect(
        tasksModule.akmTasksAdd(
          { id: "vendor-task", schedule: "0 2 * * *", command: "echo vendor" },
          { backend: fakeBackend },
        ),
      ).rejects.toThrow(/adapter "okf".*does not support AKM asset writes/i);
      expect(fs.existsSync(path.join(target.dir, "tasks", "vendor-task.yml"))).toBe(false);
      expect(backendState.installCalls).toEqual([]);
    } finally {
      iso.cleanup();
      target.cleanup();
    }
  });

  test("add writes to defaultWriteTarget instead of the primary stash", async () => {
    const iso = withIsolatedAkmStorage();
    const target = makeSandboxDir("akm-task-target");
    try {
      saveConfig({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaultWriteTarget: "target",
        bundles: { target: { path: target.dir, writable: true } },
      });

      const result = await tasksModule.akmTasksAdd(
        {
          id: "nightly",
          schedule: "0 2 * * *",
          command: "echo nightly",
        },
        { backend: fakeBackend },
      );

      expect(result.stashDir).toBe(target.dir);
      expect(fs.existsSync(path.join(target.dir, "tasks", "nightly.yml"))).toBe(true);
      expect(fs.existsSync(path.join(iso.stashDir, "tasks", "nightly.yml"))).toBe(false);
      expect(backendState.installCalls).toEqual(["nightly"]);
    } finally {
      iso.cleanup();
      target.cleanup();
    }
  });

  test("add preserves scheduler rollback behavior on install failure", async () => {
    const iso = withIsolatedAkmStorage();
    const target = makeSandboxDir("akm-task-target");
    try {
      saveConfig({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        defaultWriteTarget: "target",
        bundles: { target: { path: target.dir, writable: true } },
      });
      backendState.failInstallFor.add("broken");

      await expect(
        tasksModule.akmTasksAdd(
          {
            id: "broken",
            schedule: "0 2 * * *",
            command: "echo broken",
          },
          { backend: fakeBackend },
        ),
      ).rejects.toThrow(/install failed/);

      expect(fs.existsSync(path.join(target.dir, "tasks", "broken.yml"))).toBe(false);
    } finally {
      iso.cleanup();
      target.cleanup();
    }
  });
});
