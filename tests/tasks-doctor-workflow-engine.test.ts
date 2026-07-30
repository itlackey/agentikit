// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Q-05 — `akm task doctor` reports the workflow engine gate.
 *
 * `tasks doctor` is where an operator checks what a gated experimental surface
 * is currently doing. Before Q-05, `experimental.workflowEngine` did not exist:
 * the workflow-engine dispatch ran unconditionally, and there was nothing for
 * doctor to report. Now that the gate exists, doctor must report its state the
 * same way it already reports `improveAutonomy` — see
 * `tests/tasks-doctor-autonomy.test.ts` for the sibling gate's coverage; this
 * file pins ONLY the `workflowEngine` lines doctor adds, leaving the existing
 * `improveAutonomy` reporting untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmTasksDoctor } from "../src/commands/tasks/tasks";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { WORKFLOW_ENGINE_CONFIG_KEY } from "../src/workflows/exec/workflow-engine-gate";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "./_helpers/sandbox";

let cleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  cleanup = stashResult.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  resetConfigCache();
});

describe("tasks doctor workflow engine reporting", () => {
  test("reports the gate off by default and names the config key", async () => {
    saveConfig({ semanticSearchMode: "off" });
    resetConfigCache();

    const result = await akmTasksDoctor();

    expect(result.workflowEngine.enabled).toBe(false);
    expect(result.workflowEngine.configKey).toBe(WORKFLOW_ENGINE_CONFIG_KEY);
  });

  test("reports the gate on once experimental.workflowEngine is set", async () => {
    saveConfig({ semanticSearchMode: "off", experimental: { workflowEngine: true } });
    resetConfigCache();

    const result = await akmTasksDoctor();

    expect(result.workflowEngine.enabled).toBe(true);
    expect(result.workflowEngine.configKey).toBe(WORKFLOW_ENGINE_CONFIG_KEY);
  });

  test("workflowEngine and improveAutonomy report independently of each other", async () => {
    saveConfig({
      semanticSearchMode: "off",
      defaults: { improveStrategy: "consolidate" },
      experimental: { workflowEngine: true, improveAutonomy: false },
    });
    resetConfigCache();

    const result = await akmTasksDoctor();

    expect(result.workflowEngine.enabled).toBe(true);
    expect(result.improveAutonomy?.enabled).toBe(false);
  });
});
